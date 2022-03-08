const crypto = require('crypto');
const { promisify } = require('util');
const jwt = require('jsonwebtoken');
const User = require('../models/userModel');
const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/appError');
const sendEmail = require('../utils/email');

const signToken = (id) =>
  jwt.sign({ id }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN,
  });

exports.signUp = catchAsync(async (req, res, next) => {
  // const newUser = await User.create(req.body);

  // WE DON'T USE TOP CODE BECAUSE IT MAKES A SECURITY BUG
  // MAYBE SOMEONE SPECIFY ROLE PROPERTY IN THE BODY AND IT MEANS ANYONE WHO WANT CAN BE ADMIN
  // BUT IN BOTTOM CODE WE JUST PICK THE PROPERTIES WE WANT, EVEN SOMEONE SPECIFY ROLE PROPERY,
  // WE DON'T TAKE THAT INTO THE DATABASE
  // FOR CREATE A ADMIN WE CAN CREATE A NORMAL USER AND GO TO DATABASE AND MODIFY
  // ROLE PROPERTY TO "ADMIN" INSTEAD OF "USER".

  const newUser = await User.create({
    name: req.body.name,
    email: req.body.email,
    password: req.body.password,
    passwordConfirm: req.body.passwordConfirm,
    passwordChangedAt: req.body.passwordChangedAt,
  });

  // const token = jwt.sign({ id: newUser._id }, process.env.JWT_SECRET, {
  //   expiresIn: process.env.JWT_EXPIRES_IN,
  // });
  const token = signToken(newUser._id);
  res.status(201).json({
    status: 'success',
    token,
    user: newUser,
  });
});

exports.login = catchAsync(async (req, res, next) => {
  // 1) check user and password exist in req.body
  const { email, password } = req.body;
  if (!email || !password) {
    throw new AppError('please provide your email and password', 401);
  }
  // 2) if user exist && password is correct
  const user = await User.findOne({ email });

  // 3) if everyThing is ok, create a new token and send it to client

  if (!user || !(await user.correctPassword(password, user.password))) {
    throw new AppError('email or password are incorrect!', 401);
  }

  const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN,
  });

  res.status(200).json({
    status: 'success',
    token,
  });
});

exports.protect = catchAsync(async (req, res, next) => {
  // point: WE USULLY SEND TOKEN IN HEADER REQUEST (NOT BODY) THIS WAY => authorization: brearer <TOKEN>
  // 1) check if token exists and it's there
  let token;
  if (
    req.headers.authorization &&
    req.headers.authorization.startsWith('Bearer')
  ) {
    // req.headers.authorization.split(' ') => ['brearer', '<TOKEN>']
    token = req.headers.authorization.split(' ')[1];
  }
  if (!token) {
    throw new AppError(
      'you are not logged in! please log in and try again.',
      401
    );
  }

  // 2) verification token
  const decodeToken = await promisify(jwt.verify)(
    token,
    process.env.JWT_SECRET
  );

  // 3) check if user still exists
  const currentUser = await User.findById(decodeToken.id);
  if (!currentUser) {
    throw new AppError(
      'The user belonging to this token does no longer exist!',
      401
    );
  }

  // 4) check if user changed the password after the token was issued
  const changedPassword = currentUser.isChangedPassword(decodeToken.iat);
  if (changedPassword) {
    throw new AppError(
      'user recently changed password, please log in again!',
      401
    );
  }

  // if compiler reachs at this posit and no error has occured,
  // it means user have token correctly, so let him/her to access current middleware
  req.user = currentUser;

  next();
});

exports.restrictTo = function (...roles) {
  // roles => ['admin', 'lead-guide'] , req.user.role => 'user'
  // the main middleware
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) {
      throw new AppError('you are forbidden to access this part', 403);
    }
    next();
  };
};

exports.forgotPassword = catchAsync(async (req, res, next) => {
  // reset password flow:
  // user send a post req to {{url}}/../forgotPassword and take his/her email in body
  // we find the user by the email
  // we generate a token, then ecrypt it and save it to DB
  // the main token (not encrypted one) is gonna be sended to user email
  // user email take that token, and send to {{url}}/../resetPassword with new password
  // we encrypt the recived token and compare with ecryptedToken in DB if it was correct
  // then save new password as a main password

  // 0) check email is exist in req.body
  if (!req.body.email) {
    throw new AppError('please enter your email!', 400);
  }
  // 1) find user by email
  const user = await User.findOne({ email: req.body.email });
  if (!user) {
    throw new AppError(
      'email is not exist! make sure you put correct email otherwise try another email.',
      404
    );
  }

  // 2) create a normal token / encrypt token and store it
  const resetToken = user.createResetPasswordToken();
  await user.save({ validateBeforeSave: false });

  // 3) send the main token (not encrypted one) to email's user
  const restURL = `${req.protocol}://${req.get(
    'host'
  )}/api/v1/resetPassword/${resetToken}`;
  const message = `forgot your password? please hit a patch request to this URL and reset your password
  ${restURL}\nif you has not forgot your password please ignore this email!`;

  try {
    await sendEmail({
      email: user.email,
      subject: 'reset password (valid for 10 minutes)',
      message: message,
    });
    res.status(200).json({
      status: 'success',
      message: `we sent token to your email successfully!`,
    });
  } catch (err) {
    user.resetPassword = undefined;
    user.resetPasswordExpires = undefined;
    await user.save({ validateBeforeSave: false });
    return next(
      new AppError(
        "Oops somthing went wrong and we couldn't send email successfully, please try again!",
        500
      )
    );
  }
});

exports.resetPassword = catchAsync(async (req, res, next) => {
  // 1) check user entered his/her password and passwordConfirm in req.body
  if (!(req.body.password && req.body.passwordConfirm)) {
    throw new AppError(
      'please enter your new password and passwordConfirm!',
      400
    );
  }
  // 2) find user by token (first hash token then compare with in db one)
  const hashedToken = crypto
    .createHash('sha256')
    .update(req.params.token)
    .digest('hex');

  const user = await User.findOne({
    resetPassword: hashedToken,
    resetPasswordExpires: { $gt: Date.now() },
  });

  // 3) if token was correct, resetPasswordToken has not expired yet, set new password and passwordConfirm
  if (!user) {
    // throw new AppError('token is invalid or has expired!', 400);
    return next(new AppError('token is invalid or has expired!', 400));
  }
  user.password = req.body.password;
  user.passwordConfirm = req.body.passwordConfirm;
  user.resetPassword = undefined;
  user.resetPasswordExpires = undefined;
  await user.save();

  // 4) set changedPasswordAt
  // we did it in userModel (middleWare (userSchema.pre('save') ...));
  // 5) log in the user
  const token = await signToken(user._id);
  res.status(200).json({
    status: 'success',
    message: 'your password has changed successfully!',
    token,
  });
});

exports.updateMyPassword = catchAsync(async (req, res, next) => {
  // 0) check if user send us currentPassword, newPassword, new confirm password
  if (
    !(req.body.currentPassword && req.body.password && req.body.passwordConfirm)
  ) {
    throw new AppError(
      'please enter currentPassword, password and passwordConfirm!',
      400
    );
  }
  // 1) Get the user
  const user = await User.findById(req.user.id);
  // 2) check current password is correct or NOT
  if (!(await user.correctPassword(req.body.currentPassword, user.password))) {
    throw new AppError('current password is false!', 400);
  }
  // 3) if so, updatePassword

  // User.findAndUpdate is not gonna work.. because this way of doing update makes our validation off
  // and those functions related to userSchema.pre('save') is not gonna work and besides on that the validate function
  // in schema also not gonna work, so always when we try to update password we find user this way(User.findOne or UserFindById or)
  // and then we manipulate data and user.save()

  user.password = req.body.password;
  user.passwordConfirm = req.body.passwordConfirm;
  await user.save();
  // 4) log user in
  const token = signToken(user._id);

  res.status(200).json({
    status: 'success',
    message: 'your password has been updated successfully!',
    token,
  });
});

exports.deleteMe = catchAsync(async (req, res, next) => {
  const user = await User.findOneAndDelete({ _id: req.user._id });
  res.status(204).json({
    status: 'success',
    message: 'user has been deleted successfully!',
    user,
  });
});
